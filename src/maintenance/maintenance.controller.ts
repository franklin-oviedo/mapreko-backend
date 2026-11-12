import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiCookieAuth,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import {
  CurrentSession,
  SameOriginGuard,
  SessionGuard,
} from '../auth/auth.guard.js';
import type { AuthSession } from '../auth/auth.types.js';
import {
  ArticleQuery,
  PlanStatus,
  createPlanSchema,
  maintenanceArticleQuerySchema,
  maintenanceInput,
  maintenanceQuerySchema,
  planStatusSchema,
} from './maintenance.types.js';
import { MaintenanceService } from './maintenance.service.js';

@ApiTags('Planes de mantenimiento y conocimiento')
@Controller('api/maintenance/:application')
@UseGuards(SessionGuard)
@ApiCookieAuth('mapreko-session')
@ApiParam({ name: 'application', enum: ['user'] })
export class MaintenanceController {
  constructor(private readonly maintenance: MaintenanceService) {}

  @Get('plans')
  @ApiOperation({
    summary: 'Consultar planes y ordenes de trabajo de una propiedad accesible',
  })
  @ApiQuery({ name: 'propertyId', required: false, format: 'uuid' })
  @ApiQuery({ name: 'month', required: false, example: '2026-11' })
  plans(@CurrentSession() session: AuthSession, @Query() query: unknown) {
    return this.maintenance.listPlans(
      session,
      maintenanceInput(maintenanceQuerySchema, query),
    );
  }

  @Post('plans')
  @UseGuards(SameOriginGuard)
  @ApiHeader({ name: 'X-Mapreko-Request', required: true })
  @ApiOperation({
    summary:
      'Crear plan, tarea reutilizable y primera orden de trabajo atomicamente',
  })
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'propertyId',
        'title',
        'taskTitle',
        'priority',
        'recurrenceUnit',
        'recurrenceInterval',
        'startsOn',
        'firstDueOn',
      ],
      properties: {
        propertyId: { type: 'string', format: 'uuid' },
        title: { type: 'string', maxLength: 160 },
        description: { type: 'string', maxLength: 2000 },
        taskTitle: { type: 'string', maxLength: 160 },
        instructions: { type: 'string', maxLength: 2000 },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
        recurrenceUnit: {
          type: 'string',
          enum: ['day', 'week', 'month', 'year'],
        },
        recurrenceInterval: { type: 'integer', minimum: 1, maximum: 365 },
        startsOn: { type: 'string', format: 'date' },
        firstDueOn: { type: 'string', format: 'date' },
        estimatedMinutes: { type: 'integer', minimum: 1, maximum: 10080 },
      },
    },
  })
  createPlan(@CurrentSession() session: AuthSession, @Body() body: unknown) {
    return this.maintenance.createPlan(
      session,
      maintenanceInput(createPlanSchema, body),
    );
  }

  @Patch('plans/:id/status')
  @UseGuards(SameOriginGuard)
  @ApiHeader({ name: 'X-Mapreko-Request', required: true })
  @ApiOperation({
    summary: 'Pausar o reactivar un plan sin borrar su historial',
  })
  updateStatus(
    @CurrentSession() session: AuthSession,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const input: PlanStatus = maintenanceInput(planStatusSchema, body);
    return this.maintenance.updatePlanStatus(session, id, input.status);
  }

  @Post('activities/:id/complete')
  @UseGuards(SameOriginGuard)
  @ApiHeader({ name: 'X-Mapreko-Request', required: true })
  @ApiOperation({
    summary: 'Completar una tarea accesible y registrar su historial',
  })
  completeActivity(
    @CurrentSession() session: AuthSession,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.maintenance.completeActivity(session, id);
  }

  @Get('articles')
  @ApiOperation({
    summary: 'Guias de mantenimiento publicadas con busqueda por categoria',
  })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'category', required: false, type: String })
  articles(@CurrentSession() session: AuthSession, @Query() query: unknown) {
    const input: ArticleQuery = maintenanceInput(
      maintenanceArticleQuerySchema,
      query,
    );
    return this.maintenance.listArticles(session, input);
  }

  @Get('articles/:slug')
  @ApiOperation({ summary: 'Consultar una guia publicada por slug' })
  article(@CurrentSession() session: AuthSession, @Param('slug') slug: string) {
    return this.maintenance.article(session, slug);
  }
}
