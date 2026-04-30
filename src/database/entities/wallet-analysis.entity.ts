import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';

@Entity('wallet_analyses')
@Index(['userId', 'createdAt'])
export class WalletAnalysis {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @Column({ type: 'text' })
  walletAddress!: string;

  @Column({ type: 'numeric', precision: 5, scale: 2, default: 0 })
  winRate!: number;

  @Column({ type: 'numeric', precision: 5, scale: 2, default: 0 })
  riskScore!: number;

  @Column({ type: 'text', default: 'Balanced' })
  behaviorType!: string;

  @Column({ type: 'numeric', precision: 8, scale: 2, default: 0 })
  avgHoldTimeDays!: number;

  @Column({ type: 'numeric', precision: 8, scale: 2, default: 0 })
  tradeFrequency!: number;

  @Column({ type: 'numeric', precision: 5, scale: 2, default: 0 })
  walletHealthScore!: number;

  @Column({ type: 'int', default: 0 })
  totalTransactions!: number;

  @Column({ type: 'int', default: 0 })
  uniqueTokens!: number;

  @Column({ type: 'text', default: 'BEGINNER' })
  walletLevel!: 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED';

  @Column({ type: 'text', nullable: true })
  insight!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  rawData!: Record<string, any> | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}