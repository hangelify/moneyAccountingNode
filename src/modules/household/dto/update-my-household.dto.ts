import { Transform } from 'class-transformer';
import { IsString, Length, ValidateIf } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

// Required: null resets to the household's original name; a missing field
// is a 400, not a silent reset.
export class UpdateMyHouseholdDto {
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Дом',
    description:
      "The caller's own name for the household; null resets it to the original name",
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, 255)
  display_name!: string | null;
}
