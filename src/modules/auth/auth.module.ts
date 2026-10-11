import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { UserModule } from '../user/user.module';
import { CategoryModule } from '../category/category.module';
import { User } from '../../entities/user.entity';
import { RefreshToken } from '../../entities/refresh-token.entity';
import { Session } from '../../entities/session.entity';
import { Log } from '../../entities/log.entity';
import { Household } from '../../entities/household.entity';
import { HouseholdMember } from '../../entities/household-member.entity';
import { assertJwtSecrets, requireEnv, requireIntEnv } from './auth.env';

@Module({
  imports: [
    MikroOrmModule.forFeature([
      User,
      RefreshToken,
      Session,
      Log,
      Household,
      HouseholdMember,
    ]),
    PassportModule,
    UserModule,
    CategoryModule,
    // Env is read at bootstrap, not when this file is imported.
    JwtModule.registerAsync({
      useFactory: () => {
        assertJwtSecrets();
        return {
          secret: requireEnv('JWT_SECRET'),
          signOptions: {
            expiresIn: Math.floor(requireIntEnv('JWT_EXPIRES_IN_MS') / 1000),
          },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
