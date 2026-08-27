export const VIDEO_JOBS_STREAM = "VIDEO_JOBS";

/** Other microservices publish job requests here to submit work without using the REST API. */
export const JOB_CREATE_SUBJECT = "video.jobs.create";

/** This service publishes lifecycle events here so other microservices can subscribe. */
export const EVENTS_SUBJECT_PREFIX = "video.events";

export const JOB_CONSUMER_DURABLE = "video-jobs-worker";

export function eventSubject(status: string): string {
  return `${EVENTS_SUBJECT_PREFIX}.${status}`;
}
