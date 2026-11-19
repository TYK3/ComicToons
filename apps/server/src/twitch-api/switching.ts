import type { ParticipationHelix } from '../participation/routes.ts';
import type { HelixPolls } from '../participation/polls.ts';
import type { HelixPredictions } from '../participation/predictions.ts';
import type { HelixRewards } from '../participation/rewards.ts';
import type { TwitchHelixClient } from './helix.ts';
import type { TwitchAuthProvider } from './types.ts';

/** Everything participation can call: the fake's required methods plus the optional live-only ones. */
export type SignedInHelix = ParticipationHelix & Required<Pick<HelixRewards, 'getBroadcasterType' | 'findCustomReward' | 'updateCustomReward' | 'deleteCustomReward'>>
  & Required<Pick<HelixPolls, 'endPoll'>> & Required<Pick<HelixPredictions, 'endPrediction'>> & { mode(): Promise<'live' | 'mock'> };

/**
 * Chooses per call: the real Helix client while a broadcaster is signed in (getAuth() returns a value),
 * otherwise the in-memory fake, which stays the default when signed out. Live-only calls the fake does
 * not have (end poll, end prediction, update or delete reward, broadcaster type) are no-ops when signed out.
 */
export function createSignedInHelix(options: { auth: TwitchAuthProvider; real: TwitchHelixClient; fallback: ParticipationHelix & Partial<SignedInHelix> }): SignedInHelix {
  const { auth, real, fallback } = options;
  const live = async () => (await auth.getAuth()) !== undefined;
  return {
    async mode() { return (await live()) ? 'live' : 'mock'; },
    async createPoll(input) { return (await live()) ? real.createPoll(input) : fallback.createPoll(input); },
    async endPoll(input) { if (await live()) return real.endPoll(input); await fallback.endPoll?.(input); },
    async createCustomReward(input) { return (await live()) ? real.createCustomReward(input) : fallback.createCustomReward(input); },
    async findCustomReward(title) { return (await live()) ? real.findCustomReward(title) : fallback.findCustomReward?.(title); },
    async updateCustomReward(input) { if (await live()) return real.updateCustomReward(input); await fallback.updateCustomReward?.(input); },
    async deleteCustomReward(input) { if (await live()) return real.deleteCustomReward(input); await fallback.deleteCustomReward?.(input); },
    async getBroadcasterType() { return (await live()) ? real.getBroadcasterType() : fallback.getBroadcasterType?.(); },
    async updateRedemptionStatus(input) { return (await live()) ? real.updateRedemptionStatus(input) : fallback.updateRedemptionStatus(input); },
    async createPrediction(input) { return (await live()) ? real.createPrediction(input) : fallback.createPrediction(input); },
    async endPrediction(input) { if (await live()) return real.endPrediction(input); await fallback.endPrediction?.(input); },
    async sendChatMessage(input) { return (await live()) ? real.sendChatMessage(input) : fallback.sendChatMessage(input); },
  };
}
