/** Words printed on the paper itself, in the paper's language (separate from the app's UI language). */
export type PaperLang = 'en' | 'hi' | 'te' | 'en-hi' | 'en-te'

export const PAPER_LANGS: [PaperLang, string][] = [
  ['en', 'English'],
  ['hi', 'हिन्दी'],
  ['te', 'తెలుగు'],
  ['en-hi', 'English / हिन्दी'],
  ['en-te', 'English / తెలుగు'],
]

const WORDS = {
  class: { en: 'Class', hi: 'कक्षा', te: 'తరగతి' },
  subject: { en: 'Subject', hi: 'विषय', te: 'విషయం' },
  time: { en: 'Time', hi: 'समय', te: 'సమయం' },
  date: { en: 'Date', hi: 'दिनांक', te: 'తేదీ' },
  maxMarks: { en: 'Max. Marks', hi: 'पूर्णांक', te: 'గరిష్ఠ మార్కులు' },
  instructions: { en: 'General Instructions', hi: 'सामान्य निर्देश', te: 'సాధారణ సూచనలు' },
  marks: { en: 'Marks', hi: 'अंक', te: 'మార్కులు' },
  or: { en: 'OR', hi: 'अथवा', te: 'లేదా' },
  answerKey: { en: 'ANSWER KEY', hi: 'उत्तर कुंजी', te: 'జవాబు కీ' },
  answer: { en: 'Answer', hi: 'उत्तर', te: 'జవాబు' },
  modelAnswer: { en: 'Model answer', hi: 'आदर्श उत्तर', te: 'నమూనా జవాబు' },
  true: { en: 'True', hi: 'सत्य', te: 'సత్యం' },
  false: { en: 'False', hi: 'असत्य', te: 'అసత్యం' },
  end: { en: '*** End of Paper ***', hi: '*** प्रश्न पत्र समाप्त ***', te: '*** ప్రశ్నాపత్రం ముగిసింది ***' },
  anyOf: { en: 'Answer any {n} of the following {m} questions.', hi: 'निम्नलिखित {m} प्रश्नों में से किन्हीं {n} के उत्तर दीजिए।', te: 'కింది {m} ప్రశ్నలలో ఏవైనా {n} ప్రశ్నలకు జవాబులు రాయండి.' },
} as const

export type LabelKey = keyof typeof WORDS

/** Returns a translator for printed words; bilingual papers get "English / हिन्दी". */
export function paperLabels(lang: PaperLang = 'en') {
  const [first, second] = lang.split('-') as ('en' | 'hi' | 'te')[]
  return (key: LabelKey, vars: Record<string, string | number> = {}) => {
    const fill = (s: string) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''))
    const a = fill(WORDS[key][first])
    if (!second) return a
    const b = fill(WORDS[key][second])
    const stars = (x: string) => x.replace(/\*/g, '').trim()
    if (key === 'anyOf') return `${a}\n${b}`; // long sentences read better on two lines
    if (key === 'end') return `*** ${stars(a)} / ${stars(b)} ***`
    return `${a} / ${b}`
  }
}

