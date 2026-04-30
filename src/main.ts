import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors();

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('ChainPilot Backend API')
    .setDescription('API docs for ChainPilot backend')
    .setVersion('1.0')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);

  SwaggerModule.setup('api-docs', app, document, {
    swaggerOptions: {
      url: '/api-docs-json',
    },
  });

  app.getHttpAdapter().get('/api-docs-json', (req, res) => {
    res.json(document);
  });

  await app.init();

  // keep listen for local
  if (process.env.NODE_ENV !== 'production') {
    await app.listen(process.env.PORT ?? 3001);
  }
}

bootstrap();