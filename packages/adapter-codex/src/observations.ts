import { turnsOf, orderedEntities } from './timeline.js';
import type { OperationObservation } from '../../../src/server/backends/types.js';
export function codexObservations(state: any): OperationObservation[] {
  return turnsOf(state).map((turn) => ({
    requestIds: [
      turn.params?.clientUserMessageId,
      ...orderedEntities(turn.items)
        .filter(
          (item) =>
            item.type === 'userMessage' ||
            (item.type === 'steeringUserMessage' && item.status === 'accepted'),
        )
        .flatMap((item) => [item.clientId, item.clientUserMessageId]),
    ].filter((id): id is string => typeof id === 'string'),
    turnId: turn.turnId ?? turn.id,
    state: ['completed', 'interrupted', 'failed'].includes(turn.status) ? turn.status : 'accepted',
  }));
}
