import { BusEventWithPayload, DataHoverPayload } from '@grafana/data';

export class LegacyGraphHoverEvent extends BusEventWithPayload<DataHoverPayload> {
  static type = 'graph-hover';
}
