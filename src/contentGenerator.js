const axios = require('axios');
const logger = require('./utils/logger'); // Assuming a logger utility exists
const { addToQueue } = require('./utils/queue'); // Assuming a queue utility exists
const crypto = require('crypto'); // For generating Copyscape API signatures

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
 * Checks if content is plagiarized using the Copyscape API
 * 
 * @param {string} content - The content to check for plagiarism
 * @returns {Promise<Object>} - Results of the plagiarism check
 */
async function checkPlagiarism(content) {
  try {
    logger.info('Checking content for plagiarism via Copyscape API');
    
    // Copyscape API credentials from environment variables
    const username = process.env.COPYSCAPE_USERNAME;
    const apiKey = process.env.COPYSCAPE_API_KEY;
    
    if (!username || !apiKey) {
      logger.warn('Copyscape API credentials not configured, skipping plagiarism check');
      return {
        isPlagiarized: false,
        similarityScore: 0,
        status: 'skipped',
        message: 'Plagiarism check skipped due to missing API credentials'
      };
    }
    
    // Prepare params for Copyscape API
    const params = new URLSearchParams();
    params.append('u', username);
    params.append('k', apiKey);
    params.append('o', 'csearch'); // Content search operation
    params.append('e', 'UTF-8'); // Encoding
    params.append('t', content);
    params.append('f', 'json'); // Response format
    
    const response = await axios.post('https://www.copyscape.com/api/', params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    
    if (response.data.error) {
      throw new Error(`Copyscape API error: ${response.data.error}`);
    }
    
    // Process results
    const results = response.data.result || [];
    const totalMatches = results.length;
    
    // Calculate highest match percentage
    let highestMatchPercentage = 0;
    let matchedWords = 0;
    let totalWords = content.split(/\s+/).length;
    
    for (const result of results) {
      const wordsMatched = parseInt(result.wordsmatched, 10) || 0;
      if (wordsMatched > matchedWords) {
        matchedWords = wordsMatched;
      }
    }
    
    if (totalWords > 0 && matchedWords > 0) {
      highestMatchPercentage = (matchedWords / totalWords) * 100;
    }
    
    // Consider content plagiarized if similarity is >= 5%
    const isPlagiarized = highestMatchPercentage >= 5;
    
    logger.info(`Plagiarism check complete. Match percentage: ${highestMatchPercentage.toFixed(2)}%. Matches found: ${totalMatches}`);
    
    return {
      isPlagiarized,
      similarityScore: parseFloat(highestMatchPercentage.toFixed(2)),
      matchedWords,
      totalWords,
      totalMatches,
      status: 'completed',
      sources: results.map(r => ({
        url: r.url,
        title: r.title,
        matchedWords: parseInt(r.wordsmatched, 10) || 0,
        snippet: r.textsnippet
      }))
    };
  } catch (error) {
    logger.error('Plagiarism check failed:', error);
    
    return {
      isPlagiarized: false, // Assume not plagiarized when check fails
      status: 'error',
      message: `Plagiarism check failed: ${error.message}`,
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
 * @param {boolean} [skipPlagiarismCheck=false] - Whether to skip the plagiarism check
 * @returns {Promise<Object>} - The final processed content
 */
async function createContent(contentBrief, skipPlagiarismCheck = false) {
  // Step 1: Generate the content
  const generationResult = await generateContent(contentBrief);
  
  if (generationResult.status !== 'success') {
    return generationResult; // Return early if content generation failed
  }
  
  // Step 2: Process the content for quality metrics
  const processedResult = processContent(generationResult.content, contentBrief);
  
  // Step 3: Check for plagiarism (unless skipped)
  if (!skipPlagiarismCheck) {
    const plagiarismResult = await checkPlagiarism(processedResult.content);
    
    // If plagiarized content is detected
    if (plagiarismResult.isPlagiarized) {
      logger.warn(`Plagiarized content detected. Similarity score: ${plagiarismResult.similarityScore}%`);
      
      // Option 1: Return error and reject the content
      return {
        status: 'failed',
        message: 'Content generation failed due to plagiarism detection',
        plagiarismDetails: plagiarismResult,
        originalContent: processedResult.content // Include original for reference/debugging
      };
      
      // Option 2 (alternative): Regenerate content with stricter originality prompt
      // This could be implemented as an alternative approach
      // return regenerateWithOriginality(contentBrief, plagiarismResult);
    }
    
    // Add plagiarism check results to the response
    processedResult.plagiarismCheck = plagiarismResult;
  }
  
  // Return the final result
  return {
    ...generationResult,
    ...processedResult,
    status: 'success'
  };
}

/**
 * Regenerates content with enhanced originality instructions
 * This is an alternative approach when plagiarism is detected
 * 
 * @param {Object} contentBrief - The content brief
 * @param {Object} plagiarismResult - Results from the plagiarism check
 * @returns {Promise<Object>} - The regenerated content
 */
async function regenerateWithOriginality(contentBrief, plagiarismResult) {
  logger.info('Regenerating content with enhanced originality instructions');
  
  // Create a modified brief with stronger originality instructions
  const enhancedBrief = {
    ...contentBrief,
    forceOriginality: true
  };
  
  if (plagiarismResult.sources && plagiarismResult.sources.length > 0) {
    // Add information about detected sources to avoid
    enhancedBrief.avoidSimilarityTo = plagiarismResult.sources.map(source => 
      `"${source.title}" (${source.url})`
    ).join(', ');
  }
  
  // Generate new content with enhanced brief
  const regeneratedResult = await generateContent(enhancedBrief);
  
  if (regeneratedResult.status === 'success') {
    // Process the regenerated content
    const processedResult = processContent(regeneratedResult.content, contentBrief);
    
    // Check plagiarism again
    const secondPlagiarismCheck = await checkPlagiarism(processedResult.content);
    
    if (secondPlagiarismCheck.isPlagiarized) {
      // If still plagiarized, give up and return error
      logger.error('Regenerated content still contains plagiarism');
      return {
        status: 'failed',
        message: 'Unable to generate original content after multiple attempts',
        plagiarismDetails: secondPlagiarismCheck
      };
    }
    
    // Return successful regeneration
    return {
      ...regeneratedResult,
      ...processedResult,
      plagiarismCheck: secondPlagiarismCheck,
      wasRegenerated: true
    };
  }
  
  // If regeneration failed
  return regeneratedResult;
}

module.exports = {
  generateContent,
  createContent,
  processContent,
  checkPlagiarism,
  regenerateWithOriginality
};
