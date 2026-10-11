import { ApiProperty } from '@nestjs/swagger';

export class SessionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  created_at!: Date;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  last_activity_at!: Date | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Client IP address seen at login or the latest refresh',
  })
  ip!: string | null;

  @ApiProperty({ type: String, nullable: true })
  user_agent!: string | null;

  @ApiProperty({
    description: 'True for the session of the access token making the request',
  })
  current!: boolean;
}
