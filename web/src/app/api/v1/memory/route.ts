import db from '@codebuff/internal/db'

import { postMemory } from './_post'

import type { NextRequest } from 'next/server'

import { getUserInfoFromApiKey } from '@/db/user'
import { logger, loggerWithContext } from '@/util/logger'

export async function POST(req: NextRequest) {
  return postMemory({
    req,
    getUserInfoFromApiKey,
    logger,
    loggerWithContext,
    db,
  })
}
