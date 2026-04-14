export class AbortError extends Error {
	constructor(message = "This operation was aborted", reason = undefined) {
		super(message);
		this.name = "AbortError";
		this.reason = reason;
	}

	static is(err) {
		return err instanceof AbortError || (err != null && err.name === "AbortError");
	}
}
