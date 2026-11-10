// Paper account ledger: FIFO lots, realized/unrealized P&L, fees, margin.
import { ACCOUNT, PRODUCTS } from './config.js';
import { feesFor, pnlDollars, marginFor } from './instruments.js';

export class Account {
  constructor(inst, { startingCash = ACCOUNT.startingCash, fee = ACCOUNT.feePerContractPerSide, products = PRODUCTS } = {}) {
    this.inst = inst;
    this.products = products;
    this.startingCash = startingCash;
    this.fee = fee;
    this.lots = [];        // { qty (signed), price, time, feePerUnit }
    this.realizedGross = 0;
    this.feesPaid = 0;
    this.trades = [];      // closed round trips (FIFO matched)
    this.fills = [];
    this.maxAbsPosition = 0;
  }

  get position() { return this.lots.reduce((s, l) => s + l.qty, 0); }

  get avgEntry() {
    const q = this.position;
    if (!q) return null;
    return this.lots.reduce((s, l) => s + l.qty * l.price, 0) / q;
  }

  unrealized(mark) {
    return this.lots.reduce((s, l) => s + pnlDollars(this.inst, l.qty, l.price, mark), 0);
  }

  /** Realized P&L net of ALL fees paid so far (including entry fees of open lots). */
  get realizedNet() { return this.realizedGross - this.feesPaid; }

  equity(mark) { return this.startingCash + this.realizedNet + (this.position ? this.unrealized(mark) : 0); }

  marginUsed(lastByProduct) { return marginFor(this.inst, this.position, lastByProduct, this.products); }

  /**
   * Would a fill of `side qty` leave the account within its margin? Reducing trades are always allowed.
   * Returns { ok, required, available }.
   */
  checkMargin(side, qty, mark, lastByProduct) {
    const signed = side === 'BUY' ? qty : -qty;
    const projected = this.position + signed;
    const required = marginFor(this.inst, projected, lastByProduct, this.products);
    const available = this.equity(mark) - feesFor(this.inst, qty, this.fee);
    const pos = this.position;
    const reducing = pos !== 0 && Math.abs(projected) <= Math.abs(pos) && (projected === 0 || Math.sign(projected) === Math.sign(pos));
    return { ok: reducing || required <= available, required, available };
  }

  /** Apply a fill; returns the closed trades it produced. */
  fill({ side, qty, price, time, reason = '', lotMeta = null }) {
    const inst = this.inst;
    const signed = side === 'BUY' ? qty : -qty;
    const feePerUnit = feesFor(inst, 1, this.fee);
    const fee = feePerUnit * qty;
    this.feesPaid += fee;
    this.fills.push({ side, qty, price, time, reason, fee });
    const closed = [];
    let remaining = signed;
    while (remaining !== 0 && this.lots.length && Math.sign(this.lots[0].qty) !== Math.sign(remaining)) {
      const lot = this.lots[0];
      const matched = Math.min(Math.abs(lot.qty), Math.abs(remaining));
      const dir = Math.sign(lot.qty);
      const gross = pnlDollars(inst, dir * matched, lot.price, price);
      const fees = (lot.feePerUnit + feePerUnit) * matched;
      this.realizedGross += gross;
      const trade = {
        product: inst.id, side: dir > 0 ? 'LONG' : 'SHORT', size: matched,
        entryTime: lot.time, exitTime: time, entry: lot.price, exit: price,
        gross, fees, net: gross - fees, exitReason: reason,
        baited: Boolean(lot.meta?.baitedBy), baitHeadline: lot.meta?.baitedBy?.headline ?? '',
        meta: lot.meta ?? null,
      };
      this.trades.push(trade);
      closed.push(trade);
      lot.qty -= dir * matched;
      remaining += dir * matched;
      if (lot.qty === 0) this.lots.shift();
    }
    // qty of this fill that opened or added exposure (0 for a pure reduction)
    this.lastOpenedQty = Math.abs(remaining);
    if (remaining !== 0) this.lots.push({ qty: remaining, price, time, feePerUnit, meta: lotMeta });
    this.maxAbsPosition = Math.max(this.maxAbsPosition, Math.abs(this.position));
    return closed;
  }
}
