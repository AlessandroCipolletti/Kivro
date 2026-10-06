import { z } from 'zod';

export const WorkerCommandSchema = z.object({
  id: z.string().uuid(), jobId: z.string().uuid().optional(),
  type: z.enum(['PAUSE_ALL', 'RESUME_ALL', 'PAUSE_JOB', 'RESUME_JOB', 'CANCEL_JOB']),
  resumeWhilePaused: z.boolean().optional(),
}).strict().refine(command => !command.resumeWhilePaused || command.type === 'RESUME_JOB' && !!command.jobId,
  'Global pause confirmation is limited to one existing job');
export type WorkerCommand = z.infer<typeof WorkerCommandSchema>;
