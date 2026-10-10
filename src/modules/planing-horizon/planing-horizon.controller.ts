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
import { PlaningHorizonService } from './planing-horizon.service';
import { CreatePlaningHorizonDto } from './dto/create-planing-horizon.dto';
import { UpdatePlaningHorizonDto } from './dto/update-planing-horizon.dto';
import { PlaningHorizonResponseDto } from './dto/planing-horizon-response.dto';
import { PlaningHorizonBaseResponseDto } from './dto/planing-horizon-base-response.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { HouseholdMemberGuard } from '../household/guards/household-member.guard';
import { CurrentHousehold } from '../household/decorators/current-household.decorator';
import type { HouseholdContext } from '../household/guards/household-member.guard';
import {
  ApiCreatePlaningHorizonResponses,
  ApiGetPlaningHorizonResponses,
  ApiUpdatePlaningHorizonResponses,
  ApiDeletePlaningHorizonResponses,
  ApiListPlaningHorizonsResponses,
} from './decorators/api-responses.decorator';

@ApiTags('planing-horizons')
@Controller('households/:hid/planing-horizons')
@UseGuards(JwtAuthGuard, HouseholdMemberGuard)
@ApiBearerAuth('JWT-auth')
export class PlaningHorizonController {
  constructor(private readonly planingHorizonService: PlaningHorizonService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new planning horizon' })
  @ApiCreatePlaningHorizonResponses()
  async createPlaningHorizon(
    @CurrentHousehold() ctx: HouseholdContext,
    @Body() createPlaningHorizonDto: CreatePlaningHorizonDto,
  ): Promise<PlaningHorizonBaseResponseDto> {
    return this.planingHorizonService.createPlaningHorizon(
      ctx.householdId,
      createPlaningHorizonDto,
    );
  }

  @Get()
  @ApiOperation({
    summary: 'List all planning horizons for the current household',
  })
  @ApiListPlaningHorizonsResponses()
  async listPlaningHorizons(
    @CurrentHousehold() ctx: HouseholdContext,
  ): Promise<PlaningHorizonBaseResponseDto[]> {
    return this.planingHorizonService.listPlaningHorizons(ctx.householdId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a planning horizon by ID' })
  @ApiParam({
    name: 'id',
    description: 'Planning horizon unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiGetPlaningHorizonResponses()
  async getPlaningHorizon(
    @CurrentHousehold() ctx: HouseholdContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PlaningHorizonResponseDto> {
    return this.planingHorizonService.getPlaningHorizon(id, ctx.householdId);
  }

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a planning horizon by ID' })
  @ApiParam({
    name: 'id',
    description: 'Planning horizon unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiUpdatePlaningHorizonResponses()
  async updatePlaningHorizon(
    @CurrentHousehold() ctx: HouseholdContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updatePlaningHorizonDto: UpdatePlaningHorizonDto,
  ): Promise<PlaningHorizonBaseResponseDto> {
    return this.planingHorizonService.updatePlaningHorizon(
      id,
      ctx.householdId,
      updatePlaningHorizonDto,
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Archive a planning horizon by ID' })
  @ApiParam({
    name: 'id',
    description: 'Planning horizon unique identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiDeletePlaningHorizonResponses()
  async deletePlaningHorizon(
    @CurrentHousehold() ctx: HouseholdContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.planingHorizonService.softDeletePlaningHorizon(
      id,
      ctx.householdId,
    );
  }
}
