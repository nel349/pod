/**
 * A writing of a job's checks that did not come back, and whether it is charged all the same.
 *
 * A writing is paid for once the model has answered, whatever it said: the model's time is what it
 * costs, and a poster must not be able to steer it into useless answers for free. It is not charged
 * when the fault was ours: the model could not be reached, or Docker never started a box before the
 * writer or a trial ran.
 */
export class WritingFailed extends Error {
  override readonly name = "WritingFailed";

  constructor(message: string, readonly isCharged: boolean) {
    super(message);
  }
}
