// Public API of the exchange-rate module.
// Other modules import from here, never from files inside the module.
// The Nest module is not exported here: import it from ./<m>.module, so
// loading this barrel never pulls the module graph (and its cycles) in.

export { EXCHANGE_RATE_PROVIDER } from './exchange-rate.provider';
export { ExchangeRateService } from './exchange-rate.service';
