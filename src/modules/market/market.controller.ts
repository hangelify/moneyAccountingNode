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
  ApiOperation,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { MarketService } from './market.service';
import { CreateMarketDto } from './dto/create-market.dto';
import { UpdateMarketDto } from './dto/update-market.dto';
import { MarketResponseDto } from './dto/market-response.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { HouseholdMemberGuard } from '../household/guards/household-member.guard';
import { CurrentHousehold } from '../household/decorators/current-household.decorator';
import type { HouseholdContext } from '../household/guards/household-member.guard';
import {
  ApiCreateMarketResponses,
  ApiListMarketsResponses,
  ApiGetMarketResponses,
  ApiUpdateMarketResponses,
  ApiDeleteMarketResponses,
} from './decorators/api-responses.decorator';

@ApiTags('markets')
@Controller('households/:hid/markets')
@UseGuards(JwtAuthGuard, HouseholdMemberGuard)
@ApiBearerAuth('JWT-auth')
export class MarketController {
  constructor(private readonly marketService: MarketService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new market' })
  @ApiCreateMarketResponses()
  async createMarket(
    @CurrentHousehold() ctx: HouseholdContext,
    @Body() dto: CreateMarketDto,
  ): Promise<MarketResponseDto> {
    return this.marketService.createMarket(ctx.householdId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List all markets for the current household' })
  @ApiListMarketsResponses()
  async listMarkets(
    @CurrentHousehold() ctx: HouseholdContext,
  ): Promise<MarketResponseDto[]> {
    return this.marketService.listMarkets(ctx.householdId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a market by ID' })
  @ApiParam({
    name: 'id',
    description: 'Market unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiGetMarketResponses()
  async getMarket(
    @CurrentHousehold() ctx: HouseholdContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MarketResponseDto> {
    return this.marketService.getMarket(id, ctx.householdId);
  }

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a market by ID' })
  @ApiParam({
    name: 'id',
    description: 'Market unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiUpdateMarketResponses()
  async updateMarket(
    @CurrentHousehold() ctx: HouseholdContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMarketDto,
  ): Promise<MarketResponseDto> {
    return this.marketService.updateMarket(id, ctx.householdId, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft delete a market by ID' })
  @ApiParam({
    name: 'id',
    description: 'Market unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiDeleteMarketResponses()
  async deleteMarket(
    @CurrentHousehold() ctx: HouseholdContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.marketService.softDeleteMarket(id, ctx.householdId);
  }
}
