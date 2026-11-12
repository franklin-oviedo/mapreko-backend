import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
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
import { DashboardService } from './dashboard.service.js';
import {
  createPropertySchema,
  createTaskSchema,
  dashboardInput,
  summaryQuerySchema,
} from './dashboard.types.js';

@ApiTags('Resumen')
@ApiCookieAuth('mapreko-session')
@ApiParam({ name: 'application', enum: ['user'] })
@Controller('api/dashboard/:application')
@UseGuards(SessionGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('summary')
  @ApiOperation({
    summary:
      'Indicadores reales del mes, propiedades visibles y hasta 50 tareas pendientes',
  })
  @ApiQuery({ name: 'propertyId', required: false, format: 'uuid' })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Buscar tareas por titulo o propiedad; no cambia indicadores',
  })
  summary(@CurrentSession() session: AuthSession, @Query() query: unknown) {
    return this.dashboard.summary(
      session,
      dashboardInput(summaryQuerySchema, query),
    );
  }

  @Post('tasks')
  @UseGuards(SameOriginGuard)
  @ApiHeader({ name: 'X-Mapreko-Request', required: true })
  @ApiOperation({
    summary:
      'Crear tarea persistente y actividad de historial en una transaccion',
  })
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['propertyId', 'title', 'dueOn', 'priority'],
      properties: {
        propertyId: { type: 'string', format: 'uuid' },
        title: { type: 'string', maxLength: 160 },
        description: { type: 'string', maxLength: 2000 },
        dueOn: { type: 'string', format: 'date' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
      },
    },
  })
  createTask(@CurrentSession() session: AuthSession, @Body() body: unknown) {
    return this.dashboard.createTask(
      session,
      dashboardInput(createTaskSchema, body),
    );
  }

  @Post('properties')
  @UseGuards(SameOriginGuard)
  @ApiHeader({ name: 'X-Mapreko-Request', required: true })
  @ApiOperation({
    summary: 'Registro minimo de propiedad para comenzar a crear tareas',
  })
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['workspaceId', 'name', 'kind', 'address'],
      properties: {
        workspaceId: { type: 'string', format: 'uuid' },
        name: { type: 'string', maxLength: 120 },
        kind: {
          type: 'string',
          enum: ['house', 'apartment', 'building', 'commercial', 'other'],
        },
        address: { type: 'string', maxLength: 240 },
      },
    },
  })
  createProperty(
    @CurrentSession() session: AuthSession,
    @Body() body: unknown,
  ) {
    return this.dashboard.createProperty(
      session,
      dashboardInput(createPropertySchema, body),
    );
  }
}
