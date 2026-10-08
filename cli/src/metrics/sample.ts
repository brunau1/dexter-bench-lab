/** One metric value of one repetition: the unit the statistics work on (§2.5). */
export interface MetricSample {
  metric: string;
  /** Container service, dependency, use case or `sut`. */
  subject: string;
  /** Value of the entry's `by` label (e.g. an operation type), or '' when the metric is not split. */
  key: string;
  value: number;
}
