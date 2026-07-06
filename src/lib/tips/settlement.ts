// The money shape of a tip's transaction_settlements row: the creator is owed
// 100% of the gross, Moonbeem absorbs the Stripe fee, no distributor/platform
// cut. This is the pure spec that grant_tip (the RPC) writes and the DB
// sum-invariant enforces — kept here as the fixture's source of truth. The
// absorbed Stripe fee is Moonbeem's cost (recorded on tips.stripe_fee_absorbed_cents),
// NOT part of this split, so stripe_fee_cents is 0 here.

export type TipSettlementLegs = {
  gross_cents: number;
  post_fee_cents: number;
  stripe_fee_cents: number;
  moonbeem_take_cents: number;
  distributor_net_cents: number;
  affiliate_cut_cents: number;
  moonbeem_take_bps: number;
  creator_share_bps: number;
};

export function buildTipSettlementLegs(amountCents: number): TipSettlementLegs {
  return {
    gross_cents: amountCents,
    post_fee_cents: amountCents, // fee absorbed -> full gross flows to the split
    stripe_fee_cents: 0, // absorbed by Moonbeem (real fee on tips.stripe_fee_absorbed_cents)
    moonbeem_take_cents: 0, // zero platform fee (positioning)
    distributor_net_cents: 0, // no distributor on a tip
    affiliate_cut_cents: amountCents, // creator owed 100%
    moonbeem_take_bps: 0,
    creator_share_bps: 10000, // 100%
  };
}

// The DB-enforced sum invariant:
//   stripe_fee + moonbeem_take + distributor_net + affiliate_cut = gross
export function tipSettlementSumOk(legs: TipSettlementLegs): boolean {
  return (
    legs.stripe_fee_cents +
      legs.moonbeem_take_cents +
      legs.distributor_net_cents +
      legs.affiliate_cut_cents ===
    legs.gross_cents
  );
}
