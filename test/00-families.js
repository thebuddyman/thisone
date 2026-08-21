const FAMILY = {
  padding: /^p-/,
  margin: /^-?m-/,
  fontSize: /^text-(?:xs|sm|base|lg|xl|[2-9]xl)$/,
  textColor: /^text-(?:inherit|current|transparent|black|white|[a-z]+-\d{2,3})$/,
  bgColor: /^bg-/,
};
const cases = [
  ['p-4','padding',1],['p-12','padding',1],['px-4','padding',0],['py-2','padding',0],['pt-6','padding',0],
  ['m-4','margin',1],['-m-2','margin',1],['mx-auto','margin',0],['mb-4','margin',0],['min-h-screen','margin',0],
  ['text-sm','fontSize',1],['text-4xl','fontSize',1],['text-base','fontSize',1],['text-slate-500','fontSize',0],['text-white','fontSize',0],
  ['text-slate-900','textColor',1],['text-white','textColor',1],['text-indigo-600','textColor',1],['text-lg','textColor',0],['text-2xl','textColor',0],['text-center','textColor',0],
  ['bg-white','bgColor',1],['bg-indigo-600','bgColor',1],['bg-slate-100','bgColor',1],['border-white','bgColor',0],
];
let bad = 0;
for (const [cls, fam, want] of cases) {
  const got = FAMILY[fam].test(cls) ? 1 : 0;
  if (got !== want) { bad++; console.log(`FAIL ${fam} vs ${cls}: got ${got} want ${want}`); }
}
console.log(bad ? `${bad} failures` : `all ${cases.length} family-matching cases pass`);
