import type { LabelAnswers } from './api.ts'

export const PRODUCT_TYPE_TEXT: Record<LabelAnswers['product_type'], string> = {
  otc: 'Over-the-counter',
  prescription: 'Prescription',
}
