// Public API of the household module.
// Other modules import from here, never from files inside the module.
// The Nest module is not exported here: import it from ./<m>.module, so
// loading this barrel never pulls the module graph (and its cycles) in.

export type {
  HouseholdDetailResponseDto,
  HouseholdResponseDto,
  InviteListItemDto,
  InviteResponseDto,
} from './dto/household-response.dto';
export type { HouseholdContext } from './guards/household-member.guard';
export { CurrentHousehold } from './decorators/current-household.decorator';
export { CreateInviteDto } from './dto/create-invite.dto';
export { HouseholdMemberGuard } from './guards/household-member.guard';
export { findHouseholdRole } from './household-membership';
// Public for integration tests that drive it under concurrency.
export { HouseholdService } from './household.service';
