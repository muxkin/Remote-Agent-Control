export class DeliveryError extends Error {
  constructor(
    message: string,
    public readonly notSent = false,
    public readonly outcome?: 'failed',
  ) {
    super(message);
  }
}
