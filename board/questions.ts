import { z } from "zod";
// Producer contract. Free text is never accepted as a question presentation.
export const QuestionFields = z.object({
  title: z.string().trim().min(1).max(100).refine(s=>s.split(/\s+/).length<=12),
  context: z.string().trim().min(1).max(280),
  choices: z.array(z.object({label:z.string().trim().min(1).max(80),value:z.string().trim().min(1).max(200)}).strict()).min(1).max(4),
  default: z.string().trim().min(1).max(160),
  deadline: z.number().int().positive().nullable(),
}).strict();
export type QuestionFields = z.infer<typeof QuestionFields>;
export function questionFields(text: string): QuestionFields | null {
  try { const q=QuestionFields.safeParse(JSON.parse(text)); return q.success ? q.data : null; }
  catch { return null; }
}
