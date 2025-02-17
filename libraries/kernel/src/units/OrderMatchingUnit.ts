import { IOrder, IPeriod, OrderDirection, OrderStatus, OrderType } from '@yuants/protocol';
import { Subject, Subscription } from 'rxjs';
import { Kernel } from '../kernel';
import { BasicUnit } from './BasicUnit';
import { HistoryOrderUnit } from './HistoryOrderUnit';
import { PeriodDataUnit } from './PeriodDataUnit';
import { ProductDataUnit } from './ProductDataUnit';
import { QuoteDataUnit } from './QuoteDataUnit';

interface IMatchingRange {
  first: number;
  high: number;
  low: number;
}

/**
 * 委托订单撮合单元
 * @public
 */
export class OrderMatchingUnit extends BasicUnit {
  constructor(
    public kernel: Kernel,
    public productDataUnit: ProductDataUnit,
    public periodDataUnit: PeriodDataUnit,
    public historyOrderUnit: HistoryOrderUnit,
    public quoteDataUnit: QuoteDataUnit,
  ) {
    super(kernel);
  }

  private subscriptions: Subscription[] = [];

  private _orderSubmitted$ = new Subject<IOrder[]>();
  private _orderCancelled$ = new Subject<string[]>();

  /** Order Submit Event */
  orderSubmitted$ = this._orderSubmitted$.asObservable();
  /** Order Cancel Event */
  orderCancelled$ = this._orderCancelled$.asObservable();

  onInit(): void | Promise<void> {
    this.subscriptions.push(
      this.periodDataUnit.periodUpdated$.subscribe((period) => this.updateRangeByPeriod(period)),
    );
  }

  onDispose(): void | Promise<void> {
    for (const subscription of this.subscriptions) {
      subscription.unsubscribe();
    }
  }

  onEvent(): void | Promise<void> {
    this.doMatching();
  }

  private prevPeriodMap: Record<string, IPeriod> = {};

  private updateRangeByPeriod(period: IPeriod): void {
    const product_id = period.product_id;
    const spread = period.spread || 0;
    const key = [period.datasource_id, period.product_id, period.period_in_sec].join();
    const prevPeriod = this.prevPeriodMap[key];
    if (prevPeriod && prevPeriod.timestamp_in_us === period.timestamp_in_us) {
      // 同一K线，使用连续性的保守推断
      const first = prevPeriod.close;
      const high = Math.max(
        prevPeriod.close,
        period.close,
        period.high > prevPeriod.high ? period.high : -Infinity,
      );
      const low = Math.min(
        prevPeriod.close,
        period.close,
        period.low < prevPeriod.low ? period.low : Infinity,
      );
      this.mapProductIdToRange.set(product_id, {
        ask: {
          first: first + spread,
          high: high + spread,
          low: low + spread,
        },
        bid: {
          first,
          high,
          low,
        },
      });
    } else {
      // New Period
      this.mapProductIdToRange.set(product_id, {
        ask: {
          first: period.open + spread,
          high: period.high + spread,
          low: period.low + spread,
        },
        bid: {
          first: period.open,
          high: period.high,
          low: period.low,
        },
      });
    }
    this.prevPeriodMap[key] = period;
  }
  /**
   * 待成交订单
   */
  private mapOrderIdToOrder = new Map<string, IOrder>();
  /**
   * 撮合品种的可撮合价格范围
   */
  private mapProductIdToRange = new Map<string, { ask: IMatchingRange; bid: IMatchingRange }>();

  submitOrder(...orders: IOrder[]) {
    for (const order of orders) {
      this.mapOrderIdToOrder.set(order.client_order_id, order);
    }
    this._orderSubmitted$.next(orders);
  }

  getOrderById(id: string) {
    return this.mapOrderIdToOrder.get(id);
  }

  listOrders(): IOrder[] {
    return Array.from(this.mapOrderIdToOrder.values());
  }

  cancelOrder(...orderIds: string[]) {
    for (const id of orderIds) {
      this.mapOrderIdToOrder.delete(id);
    }
    this._orderCancelled$.next(orderIds);
  }

  private checkTradedPriceForRange = (order: IOrder): number => {
    const range = this.mapProductIdToRange.get(order.product_id)!;
    if (order.type === OrderType.MARKET) {
      if (order.direction === OrderDirection.OPEN_LONG || order.direction === OrderDirection.CLOSE_SHORT) {
        // 开多/平空
        return range.ask.first;
      } else {
        // 开空/平多
        return range.bid.first;
      }
    }
    if (order.type === OrderType.LIMIT) {
      if (order.direction === OrderDirection.OPEN_LONG || order.direction === OrderDirection.CLOSE_SHORT) {
        // 开多/平空
        if (order.price! > range.ask.first) return range.ask.first;
        if (order.price! > range.ask.low) return order.price!;
      } else {
        // 开空/平多
        if (order.price! < range.bid.first) return range.bid.first;
        if (order.price! < range.bid.high) return order.price!;
      }
    }
    if (order.type === OrderType.STOP) {
      if (order.direction === OrderDirection.OPEN_LONG || order.direction === OrderDirection.CLOSE_SHORT) {
        // 开多/平空
        if (order.price! < range.ask.first) return range.ask.first;
        if (order.price! < range.ask.high) return order.price!;
      } else {
        // 开空/平多
        if (order.price! > range.bid.first) return range.bid.first;
        if (order.price! > range.bid.low) return order.price!;
      }
    }
    return NaN;
  };

  private doMatching() {
    let isSomeOrderTraded = false;
    for (const order of this.mapOrderIdToOrder.values()) {
      const tradedPrice = this.checkTradedPriceForRange(order);
      if (Number.isNaN(tradedPrice)) {
        continue;
      }
      isSomeOrderTraded = true;
      const theOrder = {
        ...order,
        timestamp_in_us: this.kernel.currentTimestamp * 1000,
        traded_price: tradedPrice,
        traded_volume: order.volume,
        status: OrderStatus.TRADED,
      };
      // 成交
      this.kernel.log?.(
        '撮合成交',
        theOrder.product_id,
        {
          [OrderDirection.OPEN_LONG]: '开多',
          [OrderDirection.OPEN_SHORT]: '开空',
          [OrderDirection.CLOSE_LONG]: '平多',
          [OrderDirection.CLOSE_SHORT]: '平空',
        }[theOrder.direction],
        `成交价=${theOrder.traded_price}`,
        `成交量=${theOrder.traded_volume}`,
        `订单ID='${theOrder.client_order_id}'`,
        `头寸ID='${theOrder.position_id}'`,
        `账户ID='${theOrder.account_id}'`,
        `订单类型='${
          {
            [OrderType.MARKET]: '市价',
            [OrderType.LIMIT]: '限价',
            [OrderType.STOP]: '触发',
            [OrderType.IOC]: 'IOC',
            [OrderType.FOK]: 'FOK',
          }[theOrder.type]
        }'`,
        `撮合行情=${JSON.stringify(this.mapProductIdToRange.get(theOrder.product_id))}`,
      );
      this.mapOrderIdToOrder.delete(order.client_order_id);
      this.historyOrderUnit.updateOrder(theOrder);
    }
    // 撮合完成后，将所有的 range 重置为当前的 quote
    for (const [product_id, range] of this.mapProductIdToRange.entries()) {
      const quote = this.quoteDataUnit.mapProductIdToQuote[product_id];
      const ask = quote?.ask ?? 1;
      const bid = quote?.bid ?? 1;
      range.ask.first = range.ask.high = range.ask.low = ask;
      range.bid.first = range.bid.high = range.bid.low = bid;
    }
    if (isSomeOrderTraded) {
      // 撮合成功后，申请一次重计算更新上游单元状态
      const id = this.kernel.alloc(this.kernel.currentTimestamp);
      this.kernel.log?.('撮合成功，申请重计算', id);
    }
  }
}
