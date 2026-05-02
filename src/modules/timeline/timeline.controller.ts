import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AccessTokenGuard } from '../../common/guards/access-token.guard';
import { TimelineService } from './timeline.service';

@ApiTags('timeline')
@Controller('timeline')
export class TimelineController {
  constructor(private readonly timelineService: TimelineService) {}

  @Get()
  @UseGuards(AccessTokenGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Unified activity timeline' })
  @ApiResponse({ status: 200, description: 'Timeline fetched' })
  getTimeline(@Req() req: Request & { user: { sub: string } }) {
    return this.timelineService.getTimeline(req.user.sub);
  }
}