/** An expected failure (bad input, a broken base package, a missing tool): printed without a stack. */
export class RovesError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RovesError";
    }
}
