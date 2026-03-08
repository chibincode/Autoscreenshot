export interface SelectableJob {
  id: string;
}

export function getNextSelectedJobId(
  currentSelectedJobId: string | null,
  jobs: SelectableJob[],
): string | null {
  if (jobs.length === 0) {
    return null;
  }
  if (!currentSelectedJobId) {
    return jobs[0].id;
  }
  return jobs.some((job) => job.id === currentSelectedJobId) ? currentSelectedJobId : jobs[0].id;
}
