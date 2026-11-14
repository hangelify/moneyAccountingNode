// Public API of the market module.
// Other modules import from here, never from files inside the module.
// Order matters: leaf files first, the Nest module last, so a module that
// imports this barrel back during loading still finds the leaf exports.

export { MarketService } from './market.service';
export { MarketModule } from './market.module';
