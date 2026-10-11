import { ApiProperty } from '@nestjs/swagger';

export class HouseholdMemberDto {
  @ApiProperty({ format: 'uuid' })
  user_id!: string;

  @ApiProperty({ example: 'jane@example.com' })
  email!: string;

  @ApiProperty({ example: 'Jane' })
  first_name!: string;

  @ApiProperty({ example: 'Doe' })
  last_name?: string;

  @ApiProperty({ enum: ['owner', 'member'] })
  role!: 'owner' | 'member';

  @ApiProperty({ type: Date })
  joined_at!: Date;
}

export class HouseholdResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Family Budget' })
  name!: string;

  @ApiProperty({ type: Date })
  created_at!: Date;

  @ApiProperty({ example: 2 })
  member_count!: number;
}

export class HouseholdDetailResponseDto extends HouseholdResponseDto {
  @ApiProperty({ type: [HouseholdMemberDto] })
  members!: HouseholdMemberDto[];
}

export class InviteResponseDto {
  @ApiProperty({ example: 'abc123...' })
  token!: string;

  @ApiProperty({ example: 'https://app.example.com/invite/abc123...' })
  invite_url!: string;

  @ApiProperty({ type: Date })
  expires_at!: Date;
}

export class InviteListItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'jane@example.com' })
  invitee_email!: string;

  @ApiProperty({
    enum: ['pending', 'accepted', 'revoked', 'expired'],
    description: '"expired" is a pending invite past its expires_at',
  })
  status!: 'pending' | 'accepted' | 'revoked' | 'expired';

  @ApiProperty({ type: Date })
  expires_at!: Date;

  @ApiProperty({ type: Date })
  created_at!: Date;
}
