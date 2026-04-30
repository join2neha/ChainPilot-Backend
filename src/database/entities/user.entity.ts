import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum UserLevel {
  BEGINNER = 'BEGINNER',
  INTERMEDIATE = 'INTERMEDIATE',
  ADVANCED = 'ADVANCED',
}

import { WalletAnalysis } from './wallet-analysis.entity';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  walletAddress: string;

  @Column({
    type: 'enum',
    enum: UserLevel,
    default: UserLevel.BEGINNER,
  })
  level: UserLevel;

  @Column({ type: 'text', nullable: true })
  refreshTokenHash!: string | null;

  @OneToMany(() => WalletAnalysis, (analysis) => analysis.user)
  walletAnalyses!: WalletAnalysis[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}