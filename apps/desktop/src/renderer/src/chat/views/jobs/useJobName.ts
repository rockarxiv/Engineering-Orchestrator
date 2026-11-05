import { useQuery } from "@tanstack/react-query";
import { ipcQuery } from "../../../query/client";
import { jobKey } from "../../../query/hooks";

/** What a job's tab is called: its name, from the same query its view reads. */
export function useJobName(jobId: string): string {
  const query = useQuery({ queryKey: jobKey(jobId), queryFn: () => ipcQuery("jobs:get", { jobId }) });
  return query.data?.job?.name ?? "Job";
}
