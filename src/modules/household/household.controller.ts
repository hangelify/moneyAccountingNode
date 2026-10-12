import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  ParseUUIDPipe,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { HouseholdMemberGuard } from './guards/household-member.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentHousehold } from './decorators/current-household.decorator';
import type { AuthenticatedUser } from '../auth/types/jwt-payload.interface';
import type { HouseholdContext } from './guards/household-member.guard';
import { HouseholdService } from './household.service';
import { CreateHouseholdDto } from './dto/create-household.dto';
import { UpdateHouseholdDto } from './dto/update-household.dto';
import { CreateInviteDto } from './dto/create-invite.dto';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import {
  HouseholdResponseDto,
  HouseholdDetailResponseDto,
  InviteListItemDto,
  InviteResponseDto,
} from './dto/household-response.dto';

@ApiTags('households')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('households')
export class HouseholdController {
  constructor(private readonly householdService: HouseholdService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new household; caller becomes owner' })
  async createHousehold(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateHouseholdDto,
  ): Promise<HouseholdResponseDto> {
    return this.householdService.createHousehold(user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List all households the caller belongs to' })
  async listHouseholds(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<HouseholdResponseDto[]> {
    return this.householdService.listHouseholds(user.id);
  }

  @Get(':hid')
  @UseGuards(HouseholdMemberGuard)
  @ApiOperation({ summary: 'Get household details and member list' })
  @ApiParam({ name: 'hid', description: 'Household ID' })
  async getHousehold(
    @Param('hid', ParseUUIDPipe) hid: string,
  ): Promise<HouseholdDetailResponseDto> {
    return this.householdService.getHousehold(hid);
  }

  @Put(':hid')
  @UseGuards(HouseholdMemberGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rename the household (owner only)' })
  @ApiParam({ name: 'hid', description: 'Household ID' })
  async renameHousehold(
    @CurrentHousehold() ctx: HouseholdContext,
    @Param('hid', ParseUUIDPipe) hid: string,
    @Body() dto: UpdateHouseholdDto,
  ): Promise<HouseholdResponseDto> {
    this.householdService.assertOwner(ctx);
    return this.householdService.renameHousehold(hid, dto);
  }

  @Delete(':hid')
  @UseGuards(HouseholdMemberGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete the household (owner only)' })
  @ApiParam({ name: 'hid', description: 'Household ID' })
  async deleteHousehold(
    @CurrentHousehold() ctx: HouseholdContext,
    @Param('hid', ParseUUIDPipe) hid: string,
  ): Promise<void> {
    this.householdService.assertOwner(ctx);
    return this.householdService.softDeleteHousehold(hid);
  }

  @Post(':hid/invites')
  @UseGuards(HouseholdMemberGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Create an invite link (owner only). Token returned once — client delivers to invitee.',
  })
  @ApiParam({ name: 'hid', description: 'Household ID' })
  async createInvite(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentHousehold() ctx: HouseholdContext,
    @Param('hid', ParseUUIDPipe) hid: string,
    @Body() dto: CreateInviteDto,
  ): Promise<InviteResponseDto> {
    this.householdService.assertOwner(ctx);
    return this.householdService.createInvite(hid, user, dto);
  }

  @Get(':hid/invites')
  @UseGuards(HouseholdMemberGuard)
  @ApiOperation({ summary: 'List the household invites (owner only)' })
  @ApiParam({ name: 'hid', description: 'Household ID' })
  async listInvites(
    @CurrentHousehold() ctx: HouseholdContext,
    @Param('hid', ParseUUIDPipe) hid: string,
  ): Promise<InviteListItemDto[]> {
    this.householdService.assertOwner(ctx);
    return this.householdService.listInvites(hid);
  }

  @Delete(':hid/invites/:id')
  @UseGuards(HouseholdMemberGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Revoke a pending invite (owner only). Revoking twice is a no-op; an accepted invite answers 409.',
  })
  @ApiParam({ name: 'hid', description: 'Household ID' })
  @ApiParam({ name: 'id', description: 'Invite ID' })
  async revokeInvite(
    @CurrentHousehold() ctx: HouseholdContext,
    @Param('hid', ParseUUIDPipe) hid: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    this.householdService.assertOwner(ctx);
    return this.householdService.revokeInvite(hid, id);
  }

  @Post('invites/accept')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Accept a household invite. Only the user whose email the invite was issued to can accept it (403 otherwise); 409 if already a member, 410 if the invite is unknown, revoked, expired or used.',
  })
  async acceptInvite(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AcceptInviteDto,
  ): Promise<void> {
    return this.householdService.acceptInvite(dto.token, user);
  }

  @Delete(':hid/members/:uid')
  @UseGuards(HouseholdMemberGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Remove a member. Owner can remove anyone; members can only remove themselves.',
  })
  @ApiParam({ name: 'hid', description: 'Household ID' })
  @ApiParam({ name: 'uid', description: 'User ID to remove' })
  async removeMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('hid', ParseUUIDPipe) hid: string,
    @Param('uid', ParseUUIDPipe) uid: string,
  ): Promise<void> {
    return this.householdService.removeMember(hid, user.id, uid);
  }
}
