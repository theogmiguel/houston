/** The key one project goes by across environments: an environment's project ids are only unique within it. */
export function projectKeyOf(environmentId: string, projectId: string): string {
  return `${environmentId}:${projectId}`;
}
