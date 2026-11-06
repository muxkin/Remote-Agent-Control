export class DeliveryError extends Error {
  constructor(
    message: string,
    public readonly notSent = false,
  ) {
    super(message);
  }
}
