export interface Example {
  id: string;
  title: string;
  code: string;
  input?: string;
}

export const EXAMPLES: Example[] = [
  {
    id: 'hello',
    title: 'Hello, World!',
    code: `// ようこそ Baabel へ 🐑
// 左の JavaScript が中央の「羊語」にコンパイルされ、
// その羊語テキストが WebAssembly にコンパイルされて実行されます。

console.log("Hello, World!");
console.log("こんにちは、羊の世界 🐑");
`,
  },
  {
    id: 'fizzbuzz',
    title: 'FizzBuzz',
    code: `for (let i = 1; i <= 100; i++) {
  if (i % 15 == 0) console.log("FizzBuzz");
  else if (i % 3 == 0) console.log("Fizz");
  else if (i % 5 == 0) console.log("Buzz");
  else console.log(i);
}
`,
  },
  {
    id: 'kuku',
    title: '九九の表',
    code: `for (let a = 1; a <= 9; a++) {
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
    title: '素数（エラトステネスの篩）',
    code: `const N = 100;
let sieve = new Array(N).fill(0);

for (let i = 2; i < N; i++) {
  if (sieve[i] == 0) {
    print(i, " ");
    // i * i だと 8bit を超えて一周してしまうので i + i から
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
    title: '関数（GCD と素数判定）',
    code: `// 関数は呼び出し箇所にインライン展開されます（再帰は不可）
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
  if (isPrime(n)) console.log(n, "は素数");
}
`,
  },
  {
    id: 'fib',
    title: 'フィボナッチ数列',
    code: `// 値は 8bit (0〜255) なので 233 まで
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
    title: '入力：名前であいさつ',
    input: 'メリーさん',
    code: `// 右下の「標準入力」を読みます
let name = new Array(40).fill(0);
let len = 0;
let c = getchar();
while (c != 0 && c != 10 && len < 40) {
  name[len] = c;
  len++;
  c = getchar();
}

print("こんにちは、");
for (let i = 0; i < len; i++) putchar(name[i]);
console.log("！ 🐑");
console.log("入力は", len, "バイトでした");
`,
  },
  {
    id: 'sum',
    title: '入力：数値の合計',
    input: '12 34 56 78',
    code: `// readInt() は空白区切りの数値を読みます（合計も 255 まで）
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
    title: '羊を数える',
    code: `const sheep = "🐑";
for (let i = 1; i <= 10; i++) {
  print(\`羊が\${i}匹 \`);
  for (let j = 0; j < i; j++) print(sheep);
  console.log();
}
console.log("💤");
`,
  },
];
