import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  ReceiveWebhook,
  WebhookFailure,
} from './application/receive-webhook.js';

@Controller('api/v1/webhooks')
export class WebhookController {
  constructor(
    @Inject(ReceiveWebhook) private readonly receiver: ReceiveWebhook,
  ) {}
  @Post('pasarguard')
  @HttpCode(202)
  async receive(
    @Body() payload: unknown,
    @Req() request: FastifyRequest,
  ): Promise<{ accepted: true }> {
    try {
      await this.receiver.execute(
        payload,
        { headers: request.headers },
        new Date(),
      );
    } catch (error) {
      const status = error instanceof WebhookFailure ? error.status : 503;
      throw new HttpException(
        { statusCode: status, message: 'Webhook request failed' },
        status,
      );
    }
    return { accepted: true };
  }
}
