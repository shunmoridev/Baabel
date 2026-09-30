// Vite plugin: write licenses/THIRD_PARTY_LICENSES.txt listing every npm
// package that actually ends up in the build (JS and CSS/fonts), with the full
// license text from each package. The build fails if a bundled package has no
// license file, so a missing notice cannot slip into a release.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

interface Pkg {
  name: string;
  version: string;
  license: string;
  homepage?: string;
  text: string;
}

const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|txt))?$/i;

/** node_modules/<name>/ for a module id, or null for first-party code. */
function packageDir(id: string): string | null {
  const path = id.replace(/\\/g, '/').replace(/^\0/, '').split('?')[0];
  const i = path.lastIndexOf('/node_modules/');
  if (i < 0) return null;
  const rest = path.slice(i + '/node_modules/'.length).split('/');
  const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
  return path.slice(0, i + '/node_modules/'.length) + name;
}

function readPkg(dir: string): Pkg {
  const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const file = readdirSync(dir).find((f) => LICENSE_FILE.test(f));
  if (!file) throw new Error(`third-party-licenses: ${json.name} is bundled but ships no LICENSE file`);
  const repo = typeof json.repository === 'string' ? json.repository : json.repository?.url;
  return {
    name: json.name,
    version: json.version,
    license: typeof json.license === 'string' ? json.license : (json.license?.type ?? 'UNKNOWN'),
    homepage: json.homepage ?? repo?.replace(/^git\+/, '').replace(/\.git$/, ''),
    text: readFileSync(join(dir, file), 'utf8').trim(),
  };
}

export function thirdPartyLicenses(opts: { fileName?: string; header?: string } = {}): Plugin {
  const fileName = opts.fileName ?? 'licenses/THIRD_PARTY_LICENSES.txt';
  return {
    name: 'third-party-licenses',
    apply: 'build',
    generateBundle(_options, bundle) {
      const dirs = new Set<string>();
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const id of chunk.moduleIds) {
          const dir = packageDir(id);
          if (dir && existsSync(join(dir, 'package.json'))) dirs.add(dir);
        }
      }
      const pkgs = [...dirs].map(readPkg).sort((a, b) => a.name.localeCompare(b.name));
      const rule = '='.repeat(78);
      const body = pkgs
        .map((p) => [rule, `${p.name} ${p.version}`, `License: ${p.license}`, ...(p.homepage ? [p.homepage] : []), '', p.text, ''].join('\n'))
        .join('\n');
      const header = opts.header ?? 'This application bundles the following third-party software.';
      this.emitFile({ type: 'asset', fileName, source: `${header}\n\n${pkgs.map((p) => `- ${p.name} ${p.version} (${p.license})`).join('\n')}\n\n${body}` });
    },
  };
}
