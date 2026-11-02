import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { HouseholdContext } from '../guards/household-member.guard';

export const CurrentHousehold = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): HouseholdContext => {
    const request = ctx
      .switchToHttp()
      .getRequest<{ household: HouseholdContext }>();
    return request.household;
  },
);
