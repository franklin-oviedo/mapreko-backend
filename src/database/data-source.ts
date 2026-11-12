import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { databaseOptions } from './database.config.js';

export default new DataSource(databaseOptions());
