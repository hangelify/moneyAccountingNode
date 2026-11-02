import { IsString, IsOptional, Length } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateMarketDto {
  @ApiPropertyOptional({ example: 'Lidl' })
  @IsString()
  @IsOptional()
  @Length(1, 255)
  name?: string;

  @ApiPropertyOptional({ example: 'Bucharest' })
  @IsString()
  @IsOptional()
  @Length(1, 255)
  city?: string;

  @ApiPropertyOptional({ example: 'RO', minLength: 2, maxLength: 2 })
  @IsString()
  @IsOptional()
  @Length(2, 2)
  country?: string;

  @ApiPropertyOptional({ example: 'Calea Moșilor 123' })
  @IsString()
  @IsOptional()
  @Length(1, 500)
  address?: string;
}
