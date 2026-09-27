/**
 * Docker failed us: it did not answer in time, or refused to make a network or start a box.
 *
 * Kept apart from everything else that can go wrong while a box runs, because it says nothing about
 * the work inside. Work that crashes, never answers or fails a check has been tried, and is judged;
 * a box Docker never started has not, so whatever waits on it is tried again and nothing is decided,
 * or charged, by it.
 */
export class DockerFailed extends Error {
  override readonly name = "DockerFailed";
}

/**
 * The exit code `docker run` itself gives when Docker could not start the box, as opposed to the
 * command inside it failing (126, 127 and up are the box's own).
 */
export const DOCKER_COULD_NOT_START = 125;
