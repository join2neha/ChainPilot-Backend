import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors();

  //Fix favicon error (IMPORTANT for Vercel)
  app.getHttpAdapter().get('/favicon.ico', (req, res) => {
    res.status(204).send();
  });

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
    customCssUrl: 'https://unpkg.com/swagger-ui-dist@4/swagger-ui.css',
    customJs: [
      'https://unpkg.com/swagger-ui-dist@4/swagger-ui-bundle.js',
      'https://unpkg.com/swagger-ui-dist@4/swagger-ui-standalone-preset.js',
    ],
  });

  app.getHttpAdapter().get('/api-docs-json', (req, res) => {
    res.json(document);
  });

  await app.init();

  if (process.env.NODE_ENV !== 'production') {
    await app.listen(process.env.PORT ?? 3001);
  }
}

bootstrap();