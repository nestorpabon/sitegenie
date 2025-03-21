const axios = require('axios');
const logger = require('./utils/logger'); // Assuming a logger utility exists
const { addToQueue } = require('./utils/queue'); // Assuming a queue utility exists

/**
 * Generates content using OpenAI GPT-4 based on the provided content brief
 * 
 * @param {Object} contentBrief - The brief containing details for content generation
 * @param {string} contentBrief.niche - The niche/industry for the content
 * @param {string} contentBrief.topic - The main topic of the content
 * @param {string} contentBrief.primaryKeyword - The primary SEO keyword to target
 * @param {number} contentBrief.wordCount - Approximate word count for the content
 * @param {Array} contentBrief.sections - Array of section names to include
 * @param {string} contentBrief.targetAudience - Description of the target audience
 * @param {Array} [contentBrief.secondaryKeywords] - Secondary keywords to include
 * @param {string} [contentBrief.contentType] - Type of content (blog, review, etc.)
 * @param {string} [contentBrief.tone] - Desired tone of the content
 * @returns {Promise<Object>} - Object containing the generated content and metadata
 */
async function generateContent(contentBrief) {
  const systemPrompt = `You are an expert content writer specializing in ${contentBrief.niche}. 
  Create SEO-optimized content that is informative, engaging, and follows E-E-A-T principles.`;
  
  const userPrompt = `Write a comprehensive article about "${contentBrief.topic}" targeting the keyword "${contentBrief.primaryKeyword}".
  The article should be approximately ${contentBrief.wordCount} words.
  Include the following sections: ${contentBrief.sections.join(', ')}.
  Target audience: ${contentBrief.targetAudience}.
  Include factual information, statistics, and expert insights where possible.`;
  
  // Add secondary keywords if provided
  if (contentBrief.secondaryKeywords && contentBrief.secondaryKeywords.length > 0) {
    userPrompt += `\nPlease naturally incorporate these secondary keywords: ${contentBrief.secondaryKeywords.join(', ')}.`;
  }
  
  // Add tone specification if provided
  if (contentBrief.tone) {
    userPrompt += `\nThe tone of the article should be ${contentBrief.tone}.`;
  }
  
  try {
    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: Math.min(contentBrief.wordCount * 1.5, 8000), // Ensure it doesn't exceed API limits
      top_p: 1
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    
    return {
      content: response.data.choices[0].message.content,
      tokens_used: response.data.usage.total_tokens,
      completion_time: Date.now(),
      status: 'success'
    };
  } catch (error) {
    logger.error('Content generation failed:', error);
    
    if (error.response) {
      const status = error.response.status;
      
      // Handle rate limiting
      if (status === 429) {
        logger.warn('Rate limit reached, queueing content generation');
        
        // Queue for retry with exponential backoff
        await addToQueue('content-generation', contentBrief, { 
          delay: 60000, // 1 minute delay
          priority: 'high'
        });
        
        return { 
          status: 'queued', 
          message: 'Rate limit reached, content generation queued for retry' 
        };
      }
      
      // Handle other API errors
      if (status >= 400 && status < 500) {
        logger.error(`API Error: ${error.response.data.error.message}`);
      } else if (status >= 500) {
        logger.error('OpenAI service error, falling back to alternative model');
        return generateFallbackContent(contentBrief);
      }
    } else if (error.request) {
      logger.error('Network error, request made but no response received');
    } else {
      logger.error('Error setting up request:', error.message);
    }
    
    // Fall back to GPT-3.5 if any other error occurs
    return generateFallbackContent(contentBrief);
  }
}

/**
 * Fallback function that uses GPT-3.5-turbo when GPT-4 fails
 * 
 * @param {Object} contentBrief - The content brief
 * @returns {Promise<Object>} - Object containing the generated content and metadata
 */
async function generateFallbackContent(contentBrief) {
  try {
    logger.info('Attempting fallback content generation with GPT-3.5-turbo');
    
    const systemPrompt = `You are an expert content writer specializing in ${contentBrief.niche}. 
    Create SEO-optimized content that is informative and engaging.`;
    
    const userPrompt = `Write a comprehensive article about "${contentBrief.topic}" targeting the keyword "${contentBrief.primaryKeyword}".
    The article should be approximately ${contentBrief.wordCount} words.
    Include the following sections: ${contentBrief.sections.join(', ')}.
    Target audience: ${contentBrief.targetAudience}.`;
    
    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: Math.min(contentBrief.wordCount * 1.5, 4000), // GPT-3.5 has a smaller token limit
      top_p: 1
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    
    return {
      content: response.data.choices[0].message.content,
      tokens_used: response.data.usage.total_tokens,
      completion_time: Date.now(),
      status: 'success',
      model_used: 'gpt-3.5-turbo', // Indicate fallback model was used
      is_fallback: true
    };
  } catch (error) {
    logger.error('Fallback content generation failed:', error);
    
    // Both primary and fallback methods failed
    return {
      status: 'failed',
      message: 'Content generation failed, both primary and fallback methods unsuccessful',
      error: error.message
    };
  }
}

/**
 * Checks the generated content for quality and performs post-processing
 * 
 * @param {string} content - The raw generated content
 * @param {Object} contentBrief - The original content brief
 * @returns {Object} - Object containing the processed content and quality metrics
 */
function processContent(content, contentBrief) {
  // Implement content quality checks here
  // - Check for minimum word count
  // - Verify keyword inclusion and density
  // - Add internal links if needed
  // - Format headings and structure
  
  // Simple implementation for now
  const wordCount = content.split(/\s+/).length;
  const keywordDensity = (content.match(new RegExp(contentBrief.primaryKeyword, 'gi')) || []).length / wordCount * 100;
  
  const processedContent = {
    content,
    metrics: {
      wordCount,
      keywordDensity: parseFloat(keywordDensity.toFixed(2)),
      meetsMinimumLength: wordCount >= contentBrief.wordCount * 0.9,
      includesPrimaryKeyword: keywordDensity > 0
    }
  };
  
  // Add a warning if metrics are concerning
  if (!processedContent.metrics.meetsMinimumLength) {
    processedContent.warnings = processedContent.warnings || [];
    processedContent.warnings.push('Content length below target');
  }
  
  if (keywordDensity < 0.5 || keywordDensity > 3) {
    processedContent.warnings = processedContent.warnings || [];
    processedContent.warnings.push('Keyword density outside optimal range (0.5% - 3%)');
  }
  
  return processedContent;
}

/**
 * Main function to generate and process content based on a brief
 * 
 * @param {Object} contentBrief - The content brief
 * @returns {Promise<Object>} - The final processed content
 */
async function createContent(contentBrief) {
  const generationResult = await generateContent(contentBrief);
  
  if (generationResult.status === 'success') {
    const processedResult = processContent(generationResult.content, contentBrief);
    return {
      ...generationResult,
      ...processedResult
    };
  }
  
  return generationResult;
}

module.exports = {
  generateContent,
  createContent,
  processContent
};
