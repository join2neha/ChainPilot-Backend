import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from './user.entity';

@Entity('agent_memories')
@Index(['userId', 'createdAt'])
export class AgentMemory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @Column({ type: 'text' })
  txHash!: string;

  @Column({ type: 'text' })
  rootHash!: string;

  @Column({ type: 'bigint' })
  txSeq!: number;

  @Column({ type: 'text' })
  exploreUrl!: string;

  @Column({ type: 'text', nullable: true })
  goal!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  decision!: Record<string, any> | null;

  @Column({ type: 'jsonb', nullable: true })
  contextSnapshot!: Record<string, any> | null;

  @CreateDateColumn()
  createdAt!: Date;
}