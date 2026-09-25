// Drugs for the home page's sphere: every one-word name in the Gate 1 review set
// (apps/worker/scripts/review_set.txt), less nitrofurantoin while its openFDA lookups time
// out. A fixed list, never built from what visitors look up, so the page shows nothing about
// anyone's searches and needs no request to draw. Each visit shows a random SPHERE_SIZE.
export const DRUG_POOL: readonly string[] = [
  'atorvastatin',
  'simvastatin',
  'rosuvastatin',
  'pravastatin',
  'lisinopril',
  'losartan',
  'amlodipine',
  'metoprolol',
  'carvedilol',
  'hydrochlorothiazide',
  'furosemide',
  'spironolactone',
  'valsartan',
  'clopidogrel',
  'warfarin',
  'apixaban',
  'rivaroxaban',
  'metformin',
  'glipizide',
  'sitagliptin',
  'empagliflozin',
  'levothyroxine',
  'sertraline',
  'escitalopram',
  'citalopram',
  'fluoxetine',
  'bupropion',
  'trazodone',
  'duloxetine',
  'venlafaxine',
  'alprazolam',
  'lorazepam',
  'clonazepam',
  'zolpidem',
  'quetiapine',
  'aripiprazole',
  'lamotrigine',
  'gabapentin',
  'pregabalin',
  'topiramate',
  'methylphenidate',
  'sumatriptan',
  'tramadol',
  'oxycodone',
  'meloxicam',
  'celecoxib',
  'cyclobenzaprine',
  'prednisone',
  'albuterol',
  'montelukast',
  'pantoprazole',
  'ondansetron',
  'amoxicillin',
  'azithromycin',
  'doxycycline',
  'cephalexin',
  'ciprofloxacin',
  'valacyclovir',
  'fluconazole',
  'tamsulosin',
  'finasteride',
  'sildenafil',
  'oxybutynin',
  'allopurinol',
  'alendronate',
  'estradiol',
  'ibuprofen',
  'acetaminophen',
  'naproxen',
  'aspirin',
  'loratadine',
  'cetirizine',
  'fexofenadine',
  'diphenhydramine',
  'pseudoephedrine',
  'phenylephrine',
  'guaifenesin',
  'dextromethorphan',
  'doxylamine',
  'omeprazole',
  'esomeprazole',
  'famotidine',
  'loperamide',
  'docusate',
  'meclizine',
  'hydrocortisone',
  'clotrimazole',
  'nicotine',
]

// About as many names as the sphere shows before they crowd each other.
export const SPHERE_SIZE = 40

// `count` distinct names from `pool` in random order (a partial Fisher-Yates shuffle).
export function sampleDrugs(
  pool: readonly string[],
  count: number,
  random: () => number = Math.random,
): readonly string[] {
  const names = [...pool]
  const n = Math.min(count, names.length)
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(random() * (names.length - i))
    const picked = names[j]
    const current = names[i]
    if (picked === undefined || current === undefined) break
    names[i] = picked
    names[j] = current
  }
  return names.slice(0, n)
}
