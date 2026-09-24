// supabase/functions/_shared/batch.ts
// Pure aggregation for webhook message outcomes.

export type BatchMessageOutcome =
  | 'completed'
  | 'duplicate'
  | 'retry'
  | 'busy'
  | 'delivery_uncertain';

export interface BatchSummary {
  status: 'ok' | 'retry' | 'delivery_uncertain';
  httpStatus: 200 | 502;
  completed: number;
  duplicates: number;
  retries: number;
  busy: number;
  deliveryUncertain: number;
}

/**
 * Aggregate every message result before deciding the webhook response.
 */
export function aggregateBatchOutcomes(
  outcomes: BatchMessageOutcome[]
): BatchSummary {
  const summary: BatchSummary = {
    status: 'ok',
    httpStatus: 200,
    completed: 0,
    duplicates: 0,
    retries: 0,
    busy: 0,
    deliveryUncertain: 0,
  };

  for (const outcome of outcomes) {
    if (outcome === 'completed') summary.completed += 1;
    if (outcome === 'duplicate') summary.duplicates += 1;
    if (outcome === 'retry') summary.retries += 1;
    if (outcome === 'busy') summary.busy += 1;
    if (outcome === 'delivery_uncertain') summary.deliveryUncertain += 1;
  }

  if (summary.retries > 0 || summary.busy > 0) {
    summary.status = 'retry';
    summary.httpStatus = 502;
  } else if (summary.deliveryUncertain > 0) {
    summary.status = 'delivery_uncertain';
  }
  return summary;
}
