import type { Locale } from './i18n';

export interface Example {
  id: string;
  title: string;
  code: string;
  input?: string;
}

type L = Record<Locale, string>;

interface ExampleDef {
  id: string;
  title: L;
  input?: L;
  code: (l: Locale) => string;
}

const pick = (l: Locale, v: L) => v[l];

const DEFS: ExampleDef[] = [
  {
    id: 'hello',
    title: { ja: 'Hello, World!', en: 'Hello, World!', zh: 'Hello, World!' },
    code: (l) =>
      pick(l, {
        ja: `// ようこそ Baabel へ 🐑
// 左の JavaScript が中央の「羊語」にコンパイルされ、
// その羊語テキストが WebAssembly にコンパイルされて実行されます。
// 書ける構文は左下の「言語仕様」を見てください。

console.log("Hello, World!");
console.log("こんにちは、羊の世界 🐑");
`,
        en: `// Welcome to Baabel 🐑
// The JavaScript on the left is compiled into the "sheep language" in the middle,
// and that sheep text is compiled into WebAssembly and run.
// See "Language spec" at the bottom left for what you can write.

console.log("Hello, World!");
console.log("Baa! Hello from the sheep world 🐑");
`,
        zh: `// 欢迎来到 Baabel 🐑
// 左侧的 JavaScript 会被编译成中间的“羊语”，
// 再把这段羊语文本编译成 WebAssembly 并运行。
// 可以使用的语法请看左下角的“语言规范”。

console.log("Hello, World!");
console.log("你好，羊的世界 🐑");
`,
      }),
  },
  {
    id: 'fizzbuzz',
    title: { ja: 'FizzBuzz', en: 'FizzBuzz', zh: 'FizzBuzz' },
    code: () => `for (let i = 1; i <= 100; i++) {
  if (i % 15 == 0) console.log("FizzBuzz");
  else if (i % 3 == 0) console.log("Fizz");
  else if (i % 5 == 0) console.log("Buzz");
  else console.log(i);
}
`,
  },
  {
    id: 'kuku',
    title: { ja: '九九の表', en: 'Multiplication table', zh: '九九乘法表' },
    code: () => `for (let a = 1; a <= 9; a++) {
  for (let b = 1; b <= 9; b++) {
    const n = a * b;
    if (n < 10) print(" ");
    print(n, " ");
  }
  console.log();
}
`,
  },
  {
    id: 'primes',
    title: { ja: '素数（エラトステネスの篩）', en: 'Primes (sieve of Eratosthenes)', zh: '素数（埃拉托斯特尼筛法）' },
    code: (l) => `const N = 100;
let sieve = new Array(N).fill(0);

for (let i = 2; i < N; i++) {
  if (sieve[i] == 0) {
    print(i, " ");
    // ${pick(l, { ja: 'i * i だと 8bit を超えて一周してしまうので i + i から', en: 'i * i would overflow 8 bits and wrap around, so start from i + i', zh: 'i * i 会超出 8 位并回绕，所以从 i + i 开始' })}
    for (let j = i + i; j < N; j += i) {
      sieve[j] = 1;
    }
  }
}
console.log();
`,
  },
  {
    id: 'functions',
    title: { ja: '関数（GCD と素数判定）', en: 'Functions (GCD and primality)', zh: '函数（最大公约数与素数判断）' },
    code: (l) => `// ${pick(l, { ja: '関数は呼び出し箇所にインライン展開されます（再帰は不可）', en: 'Functions are inlined at each call site (no recursion)', zh: '函数会在调用处内联展开（不能递归）' })}
function gcd(a, b) {
  while (b != 0) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a;
}

function isPrime(n) {
  if (n < 2) return false;
  for (let d = 2; d * d <= n; d++) {
    if (n % d == 0) return false;
  }
  return true;
}

console.log(\`gcd(84, 36) = \${gcd(84, 36)}\`);
console.log(\`gcd(250, 75) = \${gcd(250, 75)}\`);

for (let n = 90; n < 110; n++) {
  if (isPrime(n)) console.log(n, "${pick(l, { ja: 'は素数', en: 'is prime', zh: '是素数' })}");
}
`,
  },
  {
    id: 'fib',
    title: { ja: 'フィボナッチ数列', en: 'Fibonacci numbers', zh: '斐波那契数列' },
    code: (l) => `// ${pick(l, { ja: '値は 8bit (0〜255) なので 233 まで', en: 'Values are 8-bit (0–255), so we stop at 233', zh: '值是 8 位（0〜255），所以到 233 为止' })}
let a = 0, b = 1;
while (a <= 200) {
  print(a, " ");
  const next = a + b;
  a = b;
  b = next;
}
console.log();
`,
  },
  {
    id: 'echo',
    title: { ja: '入力：名前であいさつ', en: 'Input: greet by name', zh: '输入：按名字问候' },
    input: { ja: 'メリーさん', en: 'Mary', zh: '小羊肖恩' },
    code: (l) => `// ${pick(l, { ja: '右下の「標準入力」を読みます', en: 'Reads "Standard input" at the bottom right', zh: '读取右下角的“标准输入”' })}
let name = new Array(40).fill(0);
let len = 0;
let c = getchar();
while (c != 0 && c != 10 && len < 40) {
  name[len] = c;
  len++;
  c = getchar();
}

print("${pick(l, { ja: 'こんにちは、', en: 'Hello, ', zh: '你好，' })}");
for (let i = 0; i < len; i++) putchar(name[i]);
console.log("${pick(l, { ja: '！ 🐑', en: '! 🐑', zh: '！🐑' })}");
console.log(${pick(l, { ja: '"入力は", len, "バイトでした"', en: '"The input was", len, "bytes"', zh: '"输入共", len, "字节"' })});
`,
  },
  {
    id: 'sum',
    title: { ja: '入力：数値の合計', en: 'Input: sum of numbers', zh: '输入：数字求和' },
    input: { ja: '12 34 56 78', en: '12 34 56 78', zh: '12 34 56 78' },
    code: (l) => `// ${pick(l, { ja: 'readInt() は空白区切りの数値を読みます（合計も 255 まで）', en: 'readInt() reads whitespace-separated numbers (the sum must stay ≤ 255 too)', zh: 'readInt() 读取以空白分隔的数字（总和也不能超过 255）' })}
let sum = 0;
for (let i = 0; i < 4; i++) {
  const n = readInt();
  sum += n;
  console.log("+", n, "=", sum);
}
`,
  },
  {
    id: 'sheep',
    title: { ja: '羊を数える', en: 'Counting sheep', zh: '数羊' },
    code: (l) => `const sheep = "🐑";
for (let i = 1; i <= 10; i++) {
  print(\`${pick(l, { ja: '羊が${i}匹 ', en: '${i} sheep ', zh: '${i} 只羊 ' })}\`);
  for (let j = 0; j < i; j++) print(sheep);
  console.log();
}
console.log("💤");
`,
  },
];

export function getExamples(l: Locale): Example[] {
  return DEFS.map((d) => ({ id: d.id, title: d.title[l], code: d.code(l), input: d.input?.[l] }));
}

/** Find which example (in any language) this source is, if it is unmodified. */
export function identifyExample(code: string): string | null {
  for (const d of DEFS) for (const l of ['ja', 'en', 'zh'] as Locale[]) if (d.code(l) === code) return d.id;
  return null;
}
