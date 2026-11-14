// Public API of the exchange-rate module.
// Other modules import from here, never from files inside the module.
// Order matters: leaf files first, the Nest module last, so a module that
// imports this barrel back during loading still finds the leaf exports.

export { EXCHANGE_RATE_PROVIDER } from './exchange-rate.provider';
export { ExchangeRateService } from './exchange-rate.service';
export { ExchangeRateModule } from './exchange-rate.module';
