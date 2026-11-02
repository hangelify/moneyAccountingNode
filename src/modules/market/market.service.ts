import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository, EntityManager } from '@mikro-orm/core';
import { Market } from '../../entities/market.entity';
import { Household } from '../../entities/household.entity';
import { CreateMarketDto } from './dto/create-market.dto';
import { UpdateMarketDto } from './dto/update-market.dto';
import { MarketResponseDto } from './dto/market-response.dto';

@Injectable()
export class MarketService {
  constructor(
    @InjectRepository(Market)
    private readonly marketRepository: EntityRepository<Market>,
    private readonly em: EntityManager,
  ) {}

  async createMarket(
    householdId: string,
    dto: CreateMarketDto,
  ): Promise<MarketResponseDto> {
    const market = new Market();
    market.name = dto.name;
    market.city = dto.city;
    market.country = dto.country;
    market.address = dto.address;
    market.household = this.em.getReference(Household, householdId);
    await this.em.persist(market).flush();
    return this.toDto(market);
  }

  async listMarkets(householdId: string): Promise<MarketResponseDto[]> {
    const markets = await this.marketRepository.find({
      household: { id: householdId },
      deleted_at: null,
    });

    if (markets.length === 0) return [];

    const conn = this.em.getConnection();
    const counts = (await conn.execute(
      `SELECT market_id, COUNT(*) AS cnt FROM bills WHERE market_id = ANY(?) AND status = 'confirmed' AND deleted_at IS NULL GROUP BY market_id`,
      [markets.map((m) => m.id)],
    )) as Array<{ market_id: string; cnt: string }>;
    const countMap = new Map<string, number>(
      counts.map((r) => [r.market_id, Number(r.cnt)]),
    );

    return markets
      .map(
        (m): MarketResponseDto => ({
          ...this.toDto(m),
          bill_count: countMap.get(m.id) ?? 0,
        }),
      )
      .sort(
        (a, b) =>
          b.bill_count - a.bill_count ||
          b.created_at.getTime() - a.created_at.getTime(),
      );
  }

  async getMarket(id: string, householdId: string): Promise<MarketResponseDto> {
    const market = await this.marketRepository.findOne({
      id,
      household: { id: householdId },
      deleted_at: null,
    });
    if (!market) throw new NotFoundException(`Market with ID ${id} not found`);
    return this.toDto(market);
  }

  async updateMarket(
    id: string,
    householdId: string,
    dto: UpdateMarketDto,
  ): Promise<MarketResponseDto> {
    const market = await this.marketRepository.findOne({
      id,
      household: { id: householdId },
      deleted_at: null,
    });
    if (!market) throw new NotFoundException(`Market with ID ${id} not found`);
    if (dto.name !== undefined) market.name = dto.name;
    if (dto.city !== undefined) market.city = dto.city;
    if (dto.country !== undefined) market.country = dto.country;
    if (dto.address !== undefined) market.address = dto.address;
    await this.em.persist(market).flush();
    return this.toDto(market);
  }

  async softDeleteMarket(id: string, householdId: string): Promise<void> {
    const market = await this.marketRepository.findOne({
      id,
      household: { id: householdId },
      deleted_at: null,
    });
    if (!market) throw new NotFoundException(`Market with ID ${id} not found`);
    market.deleted_at = new Date();
    await this.em.persist(market).flush();
  }

  private toDto(market: Market): MarketResponseDto {
    return {
      id: market.id,
      name: market.name,
      address: market.address,
      city: market.city,
      country: market.country,
      created_at: market.created_at,
      bill_count: 0,
    };
  }
}
