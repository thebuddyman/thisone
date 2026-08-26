const FAMILY = {
  padding: /^p-/,
  margin: /^-?m-/,
  fontSize: /^text-(?:xs|sm|base|lg|xl|[2-9]xl)$/,
  textColor: /^text-(?:inherit|current|transparent|black|white|[a-z]+-\d{2,3})$/,
  bgColor: /^bg-/,
  // rounded- covers two families. The all-corner rungs are matched by
  // membership in the ladder, never by prefix, or rounded-t-lg would be
  // stripped as if it were one of them.
  // text- is shared three ways: a size, a colour, and an alignment. Exact
  // words are the only safe test.
  textAlign: /^text-(?:left|center|right|justify|start|end)$/,
  radiusArb: /^rounded-\[[^\]]+\]$/,
  radiusSide: /^rounded-(?:t|b|l|r|s|e|tl|tr|bl|br|ss|se|es|ee)(?:-|$)/,
};

// The ladder the overlay builds from the theme, plus the two ends the utility
// bakes in. `rounded` with no suffix is the v3 alias — read, never written.
const RADII = ['none', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', 'full'];
FAMILY.radius = (cls) =>
  cls === 'rounded' ||
  /^rounded-\[[^\]]+\]$/.test(cls) ||
  (cls.startsWith('rounded-') && RADII.includes(cls.slice(8)));
const cases = [
  ['p-4','padding',1],['p-12','padding',1],['px-4','padding',0],['py-2','padding',0],['pt-6','padding',0],
  ['m-4','margin',1],['-m-2','margin',1],['mx-auto','margin',0],['mb-4','margin',0],['min-h-screen','margin',0],
  ['text-sm','fontSize',1],['text-4xl','fontSize',1],['text-base','fontSize',1],['text-slate-500','fontSize',0],['text-white','fontSize',0],
  ['text-slate-900','textColor',1],['text-white','textColor',1],['text-indigo-600','textColor',1],['text-lg','textColor',0],['text-2xl','textColor',0],['text-center','textColor',0],
  ['bg-white','bgColor',1],['bg-indigo-600','bgColor',1],['bg-slate-100','bgColor',1],['border-white','bgColor',0],
  ['rounded','radius',1],['rounded-sm','radius',1],['rounded-2xl','radius',1],['rounded-full','radius',1],['rounded-none','radius',1],['rounded-[3px]','radius',1],
  // The ones a /^rounded-/ prefix would have eaten.
  ['rounded-t-lg','radius',0],['rounded-tl-xl','radius',0],['rounded-s','radius',0],['rounded-l-[2px]','radius',0],['rounded-e-full','radius',0],
  ['rounded-t-lg','radiusSide',1],['rounded-l-[2px]','radiusSide',1],['rounded-s','radiusSide',1],['rounded-br-md','radiusSide',1],
  ['rounded-sm','radiusSide',0],['rounded-2xl','radiusSide',0],['rounded','radiusSide',0],['rounded-[3px]','radiusSide',0],
  ['text-left','textAlign',1],['text-center','textAlign',1],['text-right','textAlign',1],['text-justify','textAlign',1],
  // The three families that share the prefix must not see each other.
  ['text-lg','textAlign',0],['text-2xl','textAlign',0],['text-clay','textAlign',0],['text-slate-500','textAlign',0],['text-[13px]','textAlign',0],['text-[#fffdf9]','textAlign',0],
  ['text-center','fontSize',0],['text-center','textColor',0],
  ['rounded-[3px]','radiusArb',1],['rounded-[42px]','radiusArb',1],['rounded-l-[2px]','radiusArb',0],['rounded-xl','radiusArb',0],
];
let bad = 0;
for (const [cls, fam, want] of cases) {
  const match = FAMILY[fam];
  const got = (typeof match === 'function' ? match(cls) : match.test(cls)) ? 1 : 0;
  if (got !== want) { bad++; console.log(`FAIL ${fam} vs ${cls}: got ${got} want ${want}`); }
}
console.log(bad ? `${bad} failures` : `all ${cases.length} family-matching cases pass`);
